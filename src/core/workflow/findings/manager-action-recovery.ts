import { validateLocationSetAdmission } from './admission-validation.js';
import {
  findingFileQuoteLocations,
  formatFileQuoteLocation,
} from './evidence-location.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { applyProvisionalSettlement } from './manager-provisional-settlement.js';
import {
  isOpenProvisionalForActionRecovery,
} from './terminal-adjudication-candidates.js';
import { reconcileManagerActionRecovery } from './reconciler.js';
import type {
  FindingActionRecovery,
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  FindingReconcileContext,
} from './types.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import { FindingLedgerEntrySchema } from '../../models/finding-schemas.js';
import { applyFindingLifecycleCommands } from './lifecycle-transaction.js';

export interface ManagerActionRecoveryCandidate {
  provisionalFindingId: string;
  expectedRevision: number;
}

export interface ActionRecoveryPlan {
  output: FindingManagerOutput;
  settlements: Map<string, string>;
  failures: Map<string, string>;
}

export interface ManagerActionRecoveryLifecyclePlan {
  ledger: FindingLedger;
  output: FindingManagerOutput;
  appliedLedger: FindingLedger;
  settledLedger: FindingLedger;
  settlements: ReadonlyMap<string, string>;
  failures: ReadonlyMap<string, string>;
}

function recoveryTargetsMatch(
  ledger: FindingLedger,
  recovery: FindingActionRecovery,
): boolean {
  const targetFindingIds = recovery.action === 'duplicate'
    ? [recovery.canonicalFindingId, ...recovery.duplicateFindingIds]
    : [recovery.findingId];
  const preconditionIds = recovery.targetPreconditions.map(
    (precondition) => precondition.targetFindingId,
  );
  return new Set(preconditionIds).size === targetFindingIds.length
    && targetFindingIds.every((findingId) => preconditionIds.includes(findingId))
    && recovery.targetPreconditions.every((precondition) => (
      findingMatchesMutationPrecondition(ledger, precondition)
    ));
}

export function collectManagerActionRecoveryCandidates(
  ledger: FindingLedger,
  roundsCompleted: number,
): ManagerActionRecoveryCandidate[] {
  return ledger.findings.flatMap((finding) => (
    isOpenProvisionalForActionRecovery(finding)
      && finding.provisional.actionRecovery !== undefined
      && finding.provisional.firstObservedRound < roundsCompleted + 1
      && (finding.provisional.actionRecoveryAttempts?.length ?? 0) < 2
      ? [{ provisionalFindingId: finding.id, expectedRevision: finding.revision }]
      : []
  ));
}

function planInvalidate(
  ledger: FindingLedger,
  cwd: string,
  recovery: Extract<FindingActionRecovery, { action: 'invalidate' }>,
): { apply: boolean; settled: boolean; reason: string } {
  const target = ledger.findings.find((finding) => finding.id === recovery.findingId);
  if (target?.status === 'invalidated') {
    return { apply: false, settled: true, reason: `finding "${recovery.findingId}" is already invalidated` };
  }
  const targetLocations = target === undefined
    ? []
    : findingFileQuoteLocations(ledger, target).map(formatFileQuoteLocation);
  if (target === undefined || target.status !== 'open' || targetLocations.length === 0) {
    return { apply: false, settled: false, reason: `finding "${recovery.findingId}" is not an open located finding` };
  }
  const admission = validateLocationSetAdmission(cwd, targetLocations);
  return !admission.ok && admission.outcome === 'invalid'
    ? { apply: true, settled: false, reason: admission.reason }
    : { apply: false, settled: false, reason: 'the finding location still passes deterministic admission' };
}

function planWaive(
  ledger: FindingLedger,
  recovery: Extract<FindingActionRecovery, { action: 'waive' }>,
): { apply: boolean; settled: boolean; reason: string } {
  const target = ledger.findings.find((finding) => finding.id === recovery.findingId);
  if (target?.status === 'waived') {
    return { apply: false, settled: true, reason: `finding "${recovery.findingId}" is already waived` };
  }
  return {
    apply: false,
    settled: false,
    reason: `finding "${recovery.findingId}" requires a fresh waiver adjudication`,
  };
}

function planDuplicate(
  ledger: FindingLedger,
  recovery: Extract<FindingActionRecovery, { action: 'duplicate' }>,
): { apply: boolean; settled: boolean; reason: string } {
  const canonical = ledger.findings.find((finding) => finding.id === recovery.canonicalFindingId);
  const duplicates = recovery.duplicateFindingIds.map((findingId) => (
    ledger.findings.find((finding) => finding.id === findingId)
  ));
  const settled = duplicates.every((finding) => (
    finding?.status === 'superseded'
    && finding.supersededByFindingId === recovery.canonicalFindingId
  ));
  if (settled) {
    return { apply: false, settled: true, reason: 'the duplicate set is already superseded by the canonical finding' };
  }
  return {
    apply: false,
    settled: false,
    reason: canonical === undefined
      ? `canonical finding "${recovery.canonicalFindingId}" no longer exists`
      : 'the duplicate set requires a fresh adjudication',
  };
}

function addActionToOutput(
  output: FindingManagerOutput,
  recovery: FindingActionRecovery,
): FindingManagerOutput {
  switch (recovery.action) {
    case 'invalidate':
      return { ...output, invalidatedFindings: [...output.invalidatedFindings, recovery] };
    case 'waive':
      return { ...output, waivedFindings: [...output.waivedFindings, recovery] };
    case 'duplicate':
      return { ...output, duplicateFindings: [...output.duplicateFindings, recovery] };
  }
}

function buildActionRecoveryPlan(input: {
  ledger: FindingLedger;
  candidates: readonly ManagerActionRecoveryCandidate[];
  cwd: string;
}): ActionRecoveryPlan {
  return input.candidates.reduce<ActionRecoveryPlan>((plan, candidate) => {
    const process = input.ledger.findings.find((finding) => finding.id === candidate.provisionalFindingId);
    if (process === undefined
      || !isOpenProvisionalForActionRecovery(process)
      || process.revision !== candidate.expectedRevision
      || process.provisional.actionRecovery === undefined) {
      return plan;
    }
    const recovery = process.provisional.actionRecovery;
    if (!recoveryTargetsMatch(input.ledger, recovery)) {
      return {
        ...plan,
        failures: new Map([
          ...plan.failures,
          [process.id, 'the engine-issued action precondition no longer matches the current finding head'],
        ]),
      };
    }
    const decision = recovery.action === 'invalidate'
      ? planInvalidate(input.ledger, input.cwd, recovery)
      : recovery.action === 'waive'
        ? planWaive(input.ledger, recovery)
        : planDuplicate(input.ledger, recovery);
    if (decision.settled) {
      return {
        ...plan,
        settlements: new Map([...plan.settlements, [process.id, decision.reason]]),
      };
    }
    if (!decision.apply) {
      return {
        ...plan,
        failures: new Map([...plan.failures, [process.id, decision.reason]]),
      };
    }
    return {
      ...plan,
      output: addActionToOutput(plan.output, recovery),
      settlements: new Map([...plan.settlements, [process.id, decision.reason]]),
    };
  }, {
    output: createEmptyManagerOutput(),
    settlements: new Map(),
    failures: new Map(),
  });
}

function recordActionRecoveryFailures(
  ledger: FindingLedger,
  failures: ReadonlyMap<string, string>,
  candidates: readonly ManagerActionRecoveryCandidate[],
  observation: FindingObservation,
): FindingLedger {
  const expectedById = new Map(
    candidates.map((candidate) => [candidate.provisionalFindingId, candidate.expectedRevision]),
  );
  return {
    ...ledger,
    findings: ledger.findings.map((finding) => {
      const reason = failures.get(finding.id);
      if (!isOpenProvisionalForActionRecovery(finding)
        || reason === undefined
        || finding.revision !== expectedById.get(finding.id)) {
        return finding;
      }
      const attempts = finding.provisional.actionRecoveryAttempts ?? [];
      return {
        ...finding,
        revision: finding.revision + 1,
        provisional: {
          ...finding.provisional,
          actionRecoveryAttempts: [
            ...attempts,
            { attempt: attempts.length + 1, reason, at: observation },
          ],
        },
      };
    }),
  };
}

export function applyManagerActionRecovery(input: {
  ledger: FindingLedger;
  candidates: readonly ManagerActionRecoveryCandidate[];
  cwd: string;
  context: FindingReconcileContext;
  observation: FindingObservation;
}): FindingLedger {
  return planManagerActionRecovery(input).ledger;
}

export function planManagerActionRecovery(input: {
  ledger: FindingLedger;
  candidates: readonly ManagerActionRecoveryCandidate[];
  cwd: string;
  context: FindingReconcileContext;
  observation: FindingObservation;
}): ManagerActionRecoveryLifecyclePlan {
  const plan = buildActionRecoveryPlan(input);
  const applied = reconcileManagerActionRecovery({
    previousLedger: input.ledger,
    managerOutput: plan.output,
    context: input.context,
  });
  const settled = applyProvisionalSettlement(applied, {
    output: plan.output,
    rejectedObservationAttachments: [],
    promotedFindingIds: new Set(),
    promotionSourceRawFindingIds: new Map(),
    resolvedByMapping: plan.settlements,
    resolvedByEvidence: new Map(),
  }, input.context.timestamp);
  return {
    ledger: recordActionRecoveryFailures(
      settled,
      plan.failures,
      input.candidates,
      input.observation,
    ),
    output: plan.output,
    appliedLedger: applied,
    settledLedger: settled,
    settlements: plan.settlements,
    failures: plan.failures,
  };
}

function withoutRevision(
  finding: FindingLedger['findings'][number],
): Omit<FindingLedger['findings'][number], 'revision'> {
  const parsed = FindingLedgerEntrySchema.parse(JSON.parse(JSON.stringify(finding)));
  const change: Partial<FindingLedger['findings'][number]> = { ...parsed };
  delete change.revision;
  return change as Omit<FindingLedger['findings'][number], 'revision'>;
}

export function applyManagerActionRecoveryLifecycleCommands(input: {
  ledger: FindingLedger;
  plan: ManagerActionRecoveryLifecyclePlan | null;
  proofedLedger: FindingLedger;
  observation: FindingObservation;
}): FindingLedger {
  if (input.plan === null) {
    return input.ledger;
  }
  let ledger = input.ledger;
  for (const invalidated of input.plan.output.invalidatedFindings) {
    const projected = input.plan.appliedLedger.findings.find(
      (finding) => finding.id === invalidated.findingId,
    );
    if (projected === undefined) {
      throw new Error(
        `Action recovery invalidation references unknown finding "${invalidated.findingId}"`,
      );
    }
    const proofedFinding = input.proofedLedger.findings.find(
      (finding) => finding.id === invalidated.findingId,
    );
    if (proofedFinding?.invalidatedEvidence === undefined) {
      throw new Error(
        `Action recovery invalidation for "${invalidated.findingId}" has no verified reason`,
      );
    }
    const proofIds = input.proofedLedger.evidenceRecords.flatMap((record) => (
      record.kind === 'engine_proof'
      && record.purpose === 'lifecycle_authority'
      && record.subject.kind === 'finding_target_invalid'
      && record.subject.findingId === invalidated.findingId
        ? [record.evidenceId]
        : []
    ));
    if (proofIds.length === 0) {
      throw new Error(
        `Action recovery invalidation for "${invalidated.findingId}" has no engine proof`,
      );
    }
    ledger = applyFindingLifecycleCommands({
      ledger,
      commands: [{
        operation: 'invalidate_finding',
        changes: {
          findings: [withoutRevision({
            ...projected,
            evidenceIds: [...new Set([...projected.evidenceIds, ...proofIds])].sort(),
            invalidatedEvidence: proofedFinding.invalidatedEvidence,
          })],
          conflicts: [],
        },
        authority: { kind: 'verified_evidence' },
        evidenceSourcesByTarget: new Map([[
          `finding\0${projected.id}`,
          { sourceRawFindingIds: [], authorityEvidenceIds: proofIds },
        ]]),
      }],
      occurredAt: input.observation,
    });
  }
  for (const findingId of input.plan.settlements.keys()) {
    const projected = input.plan.settledLedger.findings.find(
      (finding) => finding.id === findingId,
    );
    const current = ledger.findings.find((finding) => finding.id === findingId);
    if (projected === undefined || current === undefined || projected.status === current.status) {
      continue;
    }
    ledger = applyFindingLifecycleCommands({
      ledger,
      commands: [{
        operation: 'resolve_finding',
        changes: { findings: [withoutRevision(projected)], conflicts: [] },
        authority: { kind: 'system', action: 'settle_action_recovery' },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: input.observation,
    });
  }
  for (const findingId of input.plan.failures.keys()) {
    const projected = input.plan.ledger.findings.find(
      (finding) => finding.id === findingId,
    );
    if (projected === undefined) {
      throw new Error(`Action recovery failure references unknown finding "${findingId}"`);
    }
    ledger = applyFindingLifecycleCommands({
      ledger,
      commands: [{
        operation: 'record_recovery_attempt',
        changes: { findings: [withoutRevision(projected)], conflicts: [] },
        authority: { kind: 'system', action: 'record_recovery_attempt' },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: input.observation,
    });
  }
  return ledger;
}
