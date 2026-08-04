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
import {
  managerDuplicateLifecycleCommandKey,
  managerProvisionalTransitionLifecycleCommandKey,
} from './manager-lifecycle-authority.js';

function mergeProofIdsByFinding(
  maps: readonly ReadonlyMap<string, readonly string[]>[],
): ReadonlyMap<string, readonly string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [findingId, proofIds] of map) {
      merged.set(
        findingId,
        [...new Set([...(merged.get(findingId) ?? []), ...proofIds])].sort(),
      );
    }
  }
  return merged;
}

function transitionProofIdsByFinding(
  commands: readonly FindingLifecycleCommand[],
  proofIdsByCommandKey: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const command of commands) {
    if (
      command.operation !== 'promote_provisional'
      && command.operation !== 'reopen_finding'
    ) {
      continue;
    }
    const proofIds = proofIdsByCommandKey.get(
      managerProvisionalTransitionLifecycleCommandKey(command),
    );
    if (proofIds === undefined) {
      continue;
    }
    const finding = command.changes.findings[0]!;
    result.set(
      finding.id,
      [...new Set([...(result.get(finding.id) ?? []), ...proofIds])].sort(),
    );
  }
  return result;
}

function duplicateProofIdsByFinding(
  proofIdsByCommandKey: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >,
): ReadonlyMap<string, readonly string[]> {
  return mergeProofIdsByFinding([...proofIdsByCommandKey.values()]);
}

function withLifecycleProofProjection(input: {
  projection: FindingLedger;
  proofed: FindingLedger;
  attachedProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
  availableProofIds: readonly string[];
}): FindingLedger {
  const availableProofIds = new Set(input.availableProofIds);
  return {
    ...input.projection,
    evidenceRecords: [
      ...new Map([
        ...input.projection.evidenceRecords,
        ...input.proofed.evidenceRecords.filter(
          (record) => availableProofIds.has(record.evidenceId),
        ),
      ].map((record) => [record.evidenceId, record])).values(),
    ],
    findings: input.projection.findings.map((finding) => ({
      ...finding,
      evidenceIds: [
        ...new Set([
          ...finding.evidenceIds,
          ...(input.attachedProofIdsByFinding.get(finding.id) ?? []),
        ]),
      ].sort(),
    })),
  };
}

function attachProvisionalTransitionProofs(
  commands: readonly FindingLifecycleCommand[],
  proofIdsByCommandKey: ReadonlyMap<string, readonly string[]>,
): FindingLifecycleCommand[] {
  return commands.map((command) => {
    if (
      command.operation !== 'promote_provisional'
      && command.operation !== 'reopen_finding'
    ) {
      return command;
    }
    const proofIds = proofIdsByCommandKey.get(
      managerProvisionalTransitionLifecycleCommandKey(command),
    ) ?? [];
    if (proofIds.length === 0) {
      return command;
    }
    const findings = command.changes.findings.map((finding) => ({
      ...finding,
      evidenceIds: [...new Set([...finding.evidenceIds, ...proofIds])].sort(),
    }));
    const evidenceSourcesByTarget = new Map(command.evidenceSourcesByTarget);
    for (const finding of findings) {
      const key = `finding\0${finding.id}`;
      const existing = evidenceSourcesByTarget.get(key) ?? {
        sourceRawFindingIds: [],
        authorityEvidenceIds: [],
      };
      evidenceSourcesByTarget.set(key, {
        sourceRawFindingIds: existing.sourceRawFindingIds,
        authorityEvidenceIds: [
          ...new Set([...existing.authorityEvidenceIds, ...proofIds]),
        ].sort(),
      });
    }
    return {
      ...command,
      changes: { ...command.changes, findings },
      evidenceSourcesByTarget,
    };
  });
}

/**
 * Translates manager decisions into lifecycle transaction groups. Independent
 * decisions remain independent events; duplicate and renotification decisions
 * are the only causal multi-target aggregates.
 */
export function assembleAndApplyManagerLifecycleTransactions(input: {
  current: FindingLedger;
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
  managerDecisionProvisionalTransitionProofIdsByCommandKey: ReadonlyMap<
    string,
    readonly string[]
  >;
  provisionalTransitionProofIdsByCommandKey: ReadonlyMap<string, readonly string[]>;
  invalidationReasonsByFinding: ReadonlyMap<string, string>;
  resolutionRenotifications: readonly ResolutionRenotificationTransition[];
  settlementCommands: readonly FindingLifecycleCommand[];
  actionRecoveryPlan: ManagerActionRecoveryLifecyclePlan | null;
  occurredAt: FindingObservation;
}): FindingLedger {
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
      if (
        command.operation === 'promote_provisional'
        || command.operation === 'reopen_finding'
      ) {
        return input.managerDecisionProvisionalTransitionProofIdsByCommandKey?.get(
          managerProvisionalTransitionLifecycleCommandKey(command),
        ) ?? [];
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
      const key = `finding\0${finding.id}`;
      const existing = evidenceSourcesByTarget.get(key) ?? {
        sourceRawFindingIds: [],
        authorityEvidenceIds: [],
      };
      evidenceSourcesByTarget.set(key, {
        sourceRawFindingIds: existing.sourceRawFindingIds,
        authorityEvidenceIds: [
          ...new Set([...existing.authorityEvidenceIds, ...proofIds]),
        ].sort(),
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
  const managerDecisionProofIdsByFinding = mergeProofIdsByFinding([
    input.provisionalProofIdsByFinding,
    input.invalidationProofIdsByFinding,
    duplicateProofIdsByFinding(input.duplicateProofIdsByCommandKey),
    transitionProofIdsByFinding(
      input.managerDecisionCommands,
      input.managerDecisionProvisionalTransitionProofIdsByCommandKey,
    ),
  ]);
  const managerDecisionProposed = withLifecycleProofProjection({
    projection: {
      ...input.managerDecisionProposed,
      findings: input.managerDecisionProposed.findings.map((finding) => (
        input.invalidationReasonsByFinding.has(finding.id)
          ? {
              ...finding,
              invalidatedEvidence: input.invalidationReasonsByFinding.get(finding.id)!,
            }
          : finding
      )),
    },
    proofed: input.proposed,
    attachedProofIdsByFinding: managerDecisionProofIdsByFinding,
    availableProofIds: input.proposed.evidenceRecords.flatMap((record) => (
      record.kind === 'engine_proof' ? [record.evidenceId] : []
    )),
  });
  const managerDecisionLedger = applyManagerDecisionLifecycleCommands({
    current: input.current,
    proposed: {
      ...managerDecisionProposed,
      evidenceBindings: input.current.evidenceBindings,
      lifecycleReservations: input.current.lifecycleReservations,
      lifecycleEvents: input.current.lifecycleEvents,
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
    commands: attachProvisionalTransitionProofs(
      input.settlementCommands,
      input.provisionalTransitionProofIdsByCommandKey ?? new Map(),
    ),
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
    },
  );
}
