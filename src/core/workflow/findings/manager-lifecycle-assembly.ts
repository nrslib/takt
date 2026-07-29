import {
  applyFindingLifecycleCommands,
  applyManagerDecisionLifecycleCommands,
  mergeFindingLifecycleCommandState,
  type FindingLifecycleCommand,
} from './lifecycle-transaction.js';
import type { ManagerDecisionStageResult } from './manager-contracts.js';
import type { ResolutionRenotificationTransition } from './resolution-renotification.js';
import { applyResolutionRenotificationLifecycleCommands } from './resolution-renotification.js';
import {
  applyManagerActionRecoveryLifecycleCommands,
  type ManagerActionRecoveryLifecyclePlan,
} from './manager-action-recovery.js';
import type { FindingLedger, FindingObservation } from './types.js';
import { managerDuplicateLifecycleCommandKey } from './manager-lifecycle-authority.js';

/**
 * Translates manager decisions into lifecycle transaction groups. Independent
 * decisions remain independent events; duplicate and renotification decisions
 * are the only causal multi-target aggregates.
 */
export function assembleAndApplyManagerLifecycleTransactions(input: {
  current: FindingLedger;
  rawRecoveryManagerDecisionProposed?: FindingLedger;
  rawRecoveryManagerDecisionCommands?: readonly FindingLifecycleCommand[];
  rawRecoveryProposed?: FindingLedger;
  rawRecoverySettlementCommands?: readonly FindingLifecycleCommand[];
  managerDecisionProposed: FindingLedger;
  managerDecisionCommands: readonly FindingLifecycleCommand[];
  proposed: FindingLedger;
  managerOutput: ManagerDecisionStageResult['managerOutput'];
  provisionalProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
  invalidationProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
  duplicateProofIdsByCommandKey: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
  invalidationReasonsByFinding: ReadonlyMap<string, string>;
  resolutionRenotifications: readonly ResolutionRenotificationTransition[];
  settlementCommands: readonly FindingLifecycleCommand[];
  actionRecoveryPlan: ManagerActionRecoveryLifecyclePlan | null;
  occurredAt: FindingObservation;
}): FindingLedger {
  const rawRecoveryManagerDecisionLedger = input.rawRecoveryManagerDecisionProposed === undefined
    ? input.current
    : applyManagerDecisionLifecycleCommands({
        current: input.current,
        proposed: input.rawRecoveryManagerDecisionProposed,
        commands: input.rawRecoveryManagerDecisionCommands ?? [],
        occurredAt: input.occurredAt,
      });
  const appliedRawRecoveryLedger = applyFindingLifecycleCommands({
    ledger: rawRecoveryManagerDecisionLedger,
    commands: input.rawRecoverySettlementCommands ?? [],
    occurredAt: input.occurredAt,
  });
  const rawRecoveryLedger = input.rawRecoveryProposed === undefined
    ? appliedRawRecoveryLedger
    : mergeFindingLifecycleCommandState(
        appliedRawRecoveryLedger,
        {
          ...input.rawRecoveryProposed,
          evidenceBindings: appliedRawRecoveryLedger.evidenceBindings,
          lifecycleReservations: appliedRawRecoveryLedger.lifecycleReservations,
          lifecycleEvents: appliedRawRecoveryLedger.lifecycleEvents,
          rawRecoveryAttempts: appliedRawRecoveryLedger.rawRecoveryAttempts,
          rawRecoveryResults: appliedRawRecoveryLedger.rawRecoveryResults,
        },
      );
  const accumulatedProofIdsByFinding = new Map<string, string[]>();
  const managerDecisionCommands = input.managerDecisionCommands.map((command) => {
    const duplicateProofIdsByTarget = command.operation === 'supersede_findings'
      ? input.duplicateProofIdsByCommandKey.get(
          managerDuplicateLifecycleCommandKey(command),
        )
      : undefined;
    const proofIdsFor = (findingId: string): readonly string[] => {
      if (command.operation === 'update_provisional') {
        return input.provisionalProofIdsByFinding.get(findingId) ?? [];
      }
      if (command.operation === 'invalidate_finding') {
        return input.invalidationProofIdsByFinding.get(findingId) ?? [];
      }
      if (command.operation === 'supersede_findings') {
        return duplicateProofIdsByTarget?.get(findingId) ?? [];
      }
      return [];
    };
    const findings = command.changes.findings.map((finding) => {
      const proofIds = proofIdsFor(finding.id);
      const accumulatedProofIds = [
        ...new Set([
          ...(accumulatedProofIdsByFinding.get(finding.id) ?? []),
          ...proofIds,
        ]),
      ].sort();
      accumulatedProofIdsByFinding.set(finding.id, accumulatedProofIds);
      return {
        ...finding,
        evidenceIds: [...new Set([...finding.evidenceIds, ...accumulatedProofIds])].sort(),
        ...(command.operation === 'invalidate_finding'
          && input.invalidationReasonsByFinding.has(finding.id)
          ? {
              invalidatedEvidence: input.invalidationReasonsByFinding.get(finding.id)!,
            }
          : {}),
      };
    });
    const evidenceSourcesByTarget = new Map(command.evidenceSourcesByTarget);
    for (const finding of findings) {
      const proofIds = proofIdsFor(finding.id);
      if (proofIds.length === 0) {
        continue;
      }
      evidenceSourcesByTarget.set(`finding\0${finding.id}`, {
        sourceRawFindingIds: [],
        authorityEvidenceIds: [...proofIds],
      });
    }
    const verifiedDuplicate = duplicateProofIdsByTarget !== undefined;
    return {
      ...command,
      changes: { ...command.changes, findings },
      evidenceSourcesByTarget,
      authority: verifiedDuplicate ? { kind: 'verified_evidence' as const } : command.authority,
    };
  });
  const managerDecisionLedger = applyManagerDecisionLifecycleCommands({
    current: rawRecoveryLedger,
    proposed: {
      ...input.managerDecisionProposed,
      evidenceBindings: rawRecoveryLedger.evidenceBindings,
      lifecycleReservations: rawRecoveryLedger.lifecycleReservations,
      lifecycleEvents: rawRecoveryLedger.lifecycleEvents,
      rawRecoveryAttempts: rawRecoveryLedger.rawRecoveryAttempts,
      rawRecoveryResults: rawRecoveryLedger.rawRecoveryResults,
    },
    commands: managerDecisionCommands,
    occurredAt: input.occurredAt,
  });
  const renotified = applyResolutionRenotificationLifecycleCommands({
    ledger: managerDecisionLedger,
    transitions: input.resolutionRenotifications,
    observation: input.occurredAt,
  });
  const settled = applyFindingLifecycleCommands({
    ledger: renotified,
    commands: input.settlementCommands,
    occurredAt: input.occurredAt,
  });
  const actionRecovered = applyManagerActionRecoveryLifecycleCommands({
    ledger: settled,
    plan: input.actionRecoveryPlan,
    proofedLedger: input.proposed,
    observation: input.occurredAt,
  });
  return mergeFindingLifecycleCommandState(
    actionRecovered,
    {
      ...input.proposed,
      evidenceBindings: actionRecovered.evidenceBindings,
      lifecycleReservations: actionRecovered.lifecycleReservations,
      lifecycleEvents: actionRecovered.lifecycleEvents,
      rawRecoveryAttempts: actionRecovered.rawRecoveryAttempts,
      rawRecoveryResults: actionRecovered.rawRecoveryResults,
    },
  );
}
