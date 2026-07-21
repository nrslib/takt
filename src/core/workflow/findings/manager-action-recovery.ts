import { validateLocationAdmission } from './admission-validation.js';
import { createEmptyManagerOutput } from './manager-output.js';
import { applyProvisionalSettlement } from './manager-provisional-settlement.js';
import { classifyProvisionalRecovery, isOpenProvisional } from './provisional-recovery.js';
import { reconcileManagerActionRecovery } from './reconciler.js';
import type {
  FindingActionRecovery,
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  FindingReconcileContext,
} from './types.js';

export interface ManagerActionRecoveryCandidate {
  provisionalFindingId: string;
  expectedRevision: number;
}

interface ActionRecoveryPlan {
  output: FindingManagerOutput;
  settlements: Map<string, string>;
  failures: Map<string, string>;
}

export function collectManagerActionRecoveryCandidates(
  ledger: FindingLedger,
  roundsCompleted: number,
): ManagerActionRecoveryCandidate[] {
  return ledger.findings.flatMap((finding) => (
    isOpenProvisional(finding)
      && classifyProvisionalRecovery(finding.provisional, roundsCompleted) === 'action'
      ? [{ provisionalFindingId: finding.id, expectedRevision: finding.revision ?? 1 }]
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
  if (target === undefined || target.status !== 'open' || target.location === undefined) {
    return { apply: false, settled: false, reason: `finding "${recovery.findingId}" is not an open located finding` };
  }
  const admission = validateLocationAdmission(cwd, target.location);
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

function planDismiss(
  ledger: FindingLedger,
  recovery: Extract<FindingActionRecovery, { action: 'dismiss' }>,
): { apply: boolean; settled: boolean; reason: string } {
  const target = ledger.findings.find((finding) => finding.id === recovery.findingId);
  if (target?.status === 'dismissed') {
    return { apply: false, settled: true, reason: `finding "${recovery.findingId}" is already dismissed` };
  }
  return {
    apply: false,
    settled: false,
    reason: `finding "${recovery.findingId}" requires a fresh dismissal adjudication`,
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
    case 'dismiss':
      return { ...output, dismissedFindings: [...output.dismissedFindings, recovery] };
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
      || !isOpenProvisional(process)
      || (process.revision ?? 1) !== candidate.expectedRevision
      || process.provisional.actionRecovery === undefined) {
      return plan;
    }
    const recovery = process.provisional.actionRecovery;
    const decision = recovery.action === 'invalidate'
      ? planInvalidate(input.ledger, input.cwd, recovery)
      : recovery.action === 'waive'
        ? planWaive(input.ledger, recovery)
        : recovery.action === 'duplicate'
          ? planDuplicate(input.ledger, recovery)
          : planDismiss(input.ledger, recovery);
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
      if (!isOpenProvisional(finding)
        || reason === undefined
        || (finding.revision ?? 1) !== expectedById.get(finding.id)) {
        return finding;
      }
      const attempts = finding.provisional.actionRecoveryAttempts ?? [];
      return {
        ...finding,
        revision: (finding.revision ?? 1) + 1,
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
  const plan = buildActionRecoveryPlan(input);
  const applied = reconcileManagerActionRecovery({
    previousLedger: input.ledger,
    managerOutput: plan.output,
    context: input.context,
  });
  const settled = applyProvisionalSettlement(applied, {
    output: plan.output,
    promotedFindingIds: new Set(),
    resolvedByMapping: plan.settlements,
    resolvedByEvidence: new Map(),
    settledReplayRawIds: new Set(),
  }, input.context.timestamp);
  return recordActionRecoveryFailures(settled, plan.failures, input.candidates, input.observation);
}
