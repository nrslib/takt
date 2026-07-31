import { createHash } from 'node:crypto';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { FindingLedgerEntrySchema } from '../../models/finding-schemas.js';
import type { ManagerDecisionStageResult } from './manager-contracts.js';
import { computeInvalidLocationCandidates } from './manager-utils.js';
import {
  createProductFindingEntry,
  isProvisionalFindingEntry,
} from './finding-entry.js';
import {
  issueProvisionalProductTransitionAuthorityProof,
} from './provisional-product-transition-proof.js';
import type {
  FindingLedger,
  FindingObservation,
  LifecycleAuthoritySubject,
} from './types.js';
import type { FindingLifecycleCommand } from './lifecycle-transaction.js';

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function managerDuplicateLifecycleCommandKey(
  command: FindingLifecycleCommand,
): string {
  if (command.operation !== 'supersede_findings') {
    throw new Error('Duplicate lifecycle command key requires supersede_findings');
  }
  return sha256({
    operation: command.operation,
    findingIds: command.changes.findings.map((finding) => finding.id),
    authority: command.authority,
  });
}

export function managerProvisionalTransitionLifecycleCommandKey(
  command: FindingLifecycleCommand,
): string {
  if (
    command.operation !== 'promote_provisional'
    && command.operation !== 'reopen_finding'
  ) {
    throw new Error('Provisional transition command key requires a product transition');
  }
  if (command.changes.findings.length !== 1) {
    throw new Error('Provisional product transition requires exactly one finding');
  }
  const findingId = command.changes.findings[0]!.id;
  const sourceRawFindingIds = provisionalTransitionRawFindingIds(
    command,
    findingId,
  );
  return sha256({
    operation: command.operation,
    findingId,
    sourceRawFindingIds,
  });
}

function provisionalTransitionRawFindingIds(
  command: FindingLifecycleCommand,
  findingId: string,
): string[] {
  const sourceRawFindingIds = command.replayOriginAuthorities === undefined
    ? command.evidenceSourcesByTarget
        .get(`finding\0${findingId}`)?.sourceRawFindingIds ?? []
    : command.replayOriginAuthorities.map(
        (authority) => authority.replayRawFindingId,
      );
  return [...new Set(sourceRawFindingIds)].sort(compareBinaryStrings);
}

function findingClaimIdentitySet(
  ledger: FindingLedger,
  findingId: string,
): string[] {
  const finding = ledger.findings.find((candidate) => candidate.id === findingId);
  if (finding === undefined) {
    throw new Error(`Duplicate proof references unknown finding "${findingId}"`);
  }
  const rawClaims = finding.rawFindingIds.flatMap((rawFindingId) => {
    const raw = ledger.rawFindings.find((candidate) => candidate.rawFindingId === rawFindingId);
    return raw === undefined ? [] : [raw.semanticClaimIdentityHash];
  });
  const claims = rawClaims.length > 0
    ? rawClaims
    : finding.semanticClaimIdentityHash === null
      ? []
      : [finding.semanticClaimIdentityHash];
  return [...new Set(claims)].sort(compareBinaryStrings);
}

/**
 * Issues deterministic proofs that permit lifecycle operations without
 * reviewer-authored raw evidence. The checks run against the current ledger
 * immediately before the lifecycle transaction is assembled.
 */
export function issueManagerLifecycleAuthority(input: {
  current: FindingLedger;
  rawRecoveryCurrent: FindingLedger;
  rawRecoveryManagerDecisionProposed: FindingLedger;
  rawRecoveryManagerDecisionCommands: readonly FindingLifecycleCommand[];
  rawRecoverySettlementCommands: readonly FindingLifecycleCommand[];
  managerDecisionProposed: FindingLedger;
  proposed: FindingLedger;
  managerDecisionCommands: readonly FindingLifecycleCommand[];
  settlementCommands: readonly FindingLifecycleCommand[];
  managerOutput: ManagerDecisionStageResult['managerOutput'];
  cwd: string;
  workflowName: string;
  runId: string;
  scopeIdentity: string;
  reviewScopeSnapshotId: string;
  observation: FindingObservation;
}): {
  ledger: FindingLedger;
  provisionalProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
  rawRecoveryProvisionalProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
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
  rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey: ReadonlyMap<
    string,
    readonly string[]
  >;
  rawRecoveryProvisionalTransitionProofIdsByCommandKey: ReadonlyMap<
    string,
    readonly string[]
  >;
  invalidationReasonsByFinding: ReadonlyMap<string, string>;
} {
  if (
    input.rawRecoveryCurrent === undefined
    || input.rawRecoveryManagerDecisionProposed === undefined
    || input.rawRecoveryManagerDecisionCommands === undefined
    || input.rawRecoverySettlementCommands === undefined
    || input.settlementCommands === undefined
  ) {
    throw new Error(
      'Lifecycle authority issuance requires complete normal and raw recovery command phases',
    );
  }
  const evidenceRecords = [...input.proposed.evidenceRecords];
  const proofIdsByFinding = new Map<string, string[]>();
  const provisionalProofIdsByFinding = new Map<string, string[]>();
  const rawRecoveryProvisionalProofIdsByFinding = new Map<string, string[]>();
  const invalidationProofIdsByFinding = new Map<string, string[]>();
  const duplicateProofIdsByCommandKey = new Map<
    string,
    ReadonlyMap<string, readonly string[]>
  >();
  const managerDecisionProvisionalTransitionProofIdsByCommandKey = new Map<
    string,
    string[]
  >();
  const provisionalTransitionProofIdsByCommandKey = new Map<string, string[]>();
  const rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey = new Map<
    string,
    string[]
  >();
  const rawRecoveryProvisionalTransitionProofIdsByCommandKey = new Map<
    string,
    string[]
  >();
  const addProof = (
    findingId: string,
    subject: LifecycleAuthoritySubject,
    result: unknown,
    claimSource?: FindingLedger['findings'][number],
    authorityBase: FindingLedger = input.current,
  ): string => {
    const currentFinding = authorityBase.findings.find(
      (candidate) => candidate.id === findingId,
    );
    const finding = currentFinding ?? input.proposed.findings.find(
      (candidate) => candidate.id === findingId,
    );
    if (finding === undefined) {
      throw new Error(`Lifecycle proof references unknown finding "${findingId}"`);
    }
    const targetFindingId = currentFinding === undefined ? null : findingId;
    const proof = createEngineProofRecord({
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      verifierId: 'takt.finding-lifecycle-policy',
      verifierVersion: '1',
      workflowName: input.workflowName,
      runId: input.runId,
      scopeIdentity: input.scopeIdentity,
      snapshotId: input.reviewScopeSnapshotId,
      claimIdentityHash: (claimSource ?? finding).claimIdentityHash,
      targetFindingId,
      subject,
      dependencyDigests: [
        captureFindingLifecycleHead(authorityBase, 'finding', findingId)?.projectionDigest
          ?? sha256({ findingId, absentHead: true }),
      ].sort(compareBinaryStrings),
      resultDigest: sha256(result),
      issuedAt: input.observation.timestamp,
    });
    evidenceRecords.push(proof);
    proofIdsByFinding.set(
      findingId,
      [...(proofIdsByFinding.get(findingId) ?? []), proof.evidenceId],
    );
    return proof.evidenceId;
  };

  // Authority for a manager-decision command is derived from that command's
  // intermediate projection. A later settlement may promote the same finding
  // in the same transaction, so the final proposed ledger is not an authority
  // source for update_provisional.
  for (const proposal of input.managerDecisionProposed.findings) {
    const finding = FindingLedgerEntrySchema.parse(proposal);
    const current = input.current.findings.find(
      (candidate) => candidate.id === finding.id,
    );
    if (
      finding.provisional === undefined
      || finding.status !== 'open'
      || !input.managerDecisionCommands.some((command) => (
        command.operation === 'update_provisional'
        && command.changes.findings.some((candidate) => candidate.id === finding.id)
      ))
      || (
        current !== undefined
        && canonicalJson(JSON.parse(JSON.stringify(current)))
          === canonicalJson(JSON.parse(JSON.stringify(finding)))
      )
    ) {
      continue;
    }
    const proofId = addProof(
      finding.id,
      {
        kind: 'finding_provisional_isolation',
        findingId: finding.id,
        provisionalKind: finding.provisional.kind,
        stableKey: finding.provisional.stableKey,
      },
      {
        findingId: finding.id,
        provisionalKind: finding.provisional.kind,
        sourceRawFindingIds: finding.provisional.sourceRawFindingIds,
        isolated: true,
      },
      finding,
    );
    provisionalProofIdsByFinding.set(
      finding.id,
      [...(provisionalProofIdsByFinding.get(finding.id) ?? []), proofId],
    );
  }

  if (
    input.rawRecoveryCurrent !== undefined
    && input.rawRecoveryManagerDecisionProposed !== undefined
  ) {
    for (const proposal of input.rawRecoveryManagerDecisionProposed.findings) {
      const finding = FindingLedgerEntrySchema.parse(proposal);
      const current = input.rawRecoveryCurrent.findings.find(
        (candidate) => candidate.id === finding.id,
      );
      if (
        finding.provisional === undefined
        || finding.status !== 'open'
        || !(input.rawRecoveryManagerDecisionCommands ?? []).some((command) => (
          command.operation === 'update_provisional'
          && command.changes.findings.some((candidate) => candidate.id === finding.id)
        ))
        || (
          current !== undefined
          && canonicalJson(JSON.parse(JSON.stringify(current)))
            === canonicalJson(JSON.parse(JSON.stringify(finding)))
        )
      ) {
        continue;
      }
      const proofId = addProof(
        finding.id,
        {
          kind: 'finding_provisional_isolation',
          findingId: finding.id,
          provisionalKind: finding.provisional.kind,
          stableKey: finding.provisional.stableKey,
        },
        {
          findingId: finding.id,
          provisionalKind: finding.provisional.kind,
          sourceRawFindingIds: finding.provisional.sourceRawFindingIds,
          isolated: true,
        },
        finding,
        input.rawRecoveryCurrent,
      );
      rawRecoveryProvisionalProofIdsByFinding.set(
        finding.id,
        [...(rawRecoveryProvisionalProofIdsByFinding.get(finding.id) ?? []), proofId],
      );
    }
  }

  const invalidCandidates = computeInvalidLocationCandidates(input.cwd, input.current);
  const invalidationReasonsByFinding = new Map<string, string>();
  for (const invalidated of input.managerOutput.invalidatedFindings) {
    const reason = invalidCandidates.get(invalidated.findingId);
    if (reason === undefined) {
      throw new Error(
        `Finding "${invalidated.findingId}" failed commit-time invalidation verification`,
      );
    }
    invalidationReasonsByFinding.set(invalidated.findingId, reason);
    const proofId = addProof(
      invalidated.findingId,
      {
        kind: 'finding_target_invalid',
        findingId: invalidated.findingId,
        reason,
      },
      { findingId: invalidated.findingId, invalid: true, reason },
    );
    invalidationProofIdsByFinding.set(
      invalidated.findingId,
      [...(invalidationProofIdsByFinding.get(invalidated.findingId) ?? []), proofId],
    );
  }

  for (const duplicate of input.managerOutput.duplicateFindings) {
    const findingIds = [
      duplicate.canonicalFindingId,
      ...duplicate.duplicateFindingIds,
    ].sort(compareBinaryStrings);
    const claimSets = findingIds.map((findingId) => (
      findingClaimIdentitySet(input.current, findingId)
    ));
    if (
      claimSets.length === 0
      || claimSets.some((claimSet) => canonicalJson(claimSet) !== canonicalJson(claimSets[0]))
    ) {
      continue;
    }
    const decisionDigest = sha256(duplicate);
    const command = input.managerDecisionCommands.find((candidate) => (
      candidate.operation === 'supersede_findings'
      && candidate.authority.kind === 'engine_policy'
      && candidate.authority.decisionKind === 'semantic_duplicate'
      && candidate.authority.decisionDigest === decisionDigest
    ));
    if (command === undefined) {
      throw new Error(
        `Verified duplicate decision for "${duplicate.canonicalFindingId}" has no semantic command`,
      );
    }
    const proofIdsByTarget = new Map<string, string[]>();
    for (const findingId of findingIds) {
      const proofId = addProof(
        findingId,
        {
          kind: 'finding_claim_sets_equal',
          findingIds,
          semanticClaimIdentityHashes: claimSets[0]!,
        },
        { findingIds, semanticClaimIdentityHashes: claimSets[0] },
      );
      proofIdsByTarget.set(
        findingId,
        [...(proofIdsByTarget.get(findingId) ?? []), proofId],
      );
    }
    const commandKey = managerDuplicateLifecycleCommandKey(command);
    if (duplicateProofIdsByCommandKey.has(commandKey)) {
      throw new Error(`Duplicate lifecycle command key collision "${commandKey}"`);
    }
    duplicateProofIdsByCommandKey.set(commandKey, proofIdsByTarget);
  }

  const issueTransitionProofs = (phase: {
    observationLedger: FindingLedger;
    intermediateLedger: FindingLedger;
    commands: readonly FindingLifecycleCommand[];
    proofIdsByCommandKey: Map<string, string[]>;
    priorProofIdsByFinding?: ReadonlyMap<string, readonly string[]>;
  }): void => {
    for (const command of phase.commands) {
      if (
        command.operation !== 'promote_provisional'
        && command.operation !== 'reopen_finding'
      ) {
        continue;
      }
      if (command.changes.findings.length !== 1) {
        throw new Error(
          `Lifecycle operation "${command.operation}" requires exactly one finding change`,
        );
      }
      const change = command.changes.findings[0]!;
      const priorProofIds = phase.priorProofIdsByFinding?.get(change.id) ?? [];
      const intermediateLedger: FindingLedger = priorProofIds.length === 0
        ? phase.intermediateLedger
        : {
            ...phase.intermediateLedger,
            findings: phase.intermediateLedger.findings.map((finding) => (
              finding.id === change.id
                ? {
                    ...finding,
                    evidenceIds: [
                      ...new Set([...finding.evidenceIds, ...priorProofIds]),
                    ].sort(compareBinaryStrings),
                  }
                : finding
            )),
          };
      const provisional = intermediateLedger.findings.find(
        (candidate) => candidate.id === change.id,
      );
      if (
        provisional === undefined
        || !isProvisionalFindingEntry(provisional)
        || change.provisional !== undefined
      ) {
        continue;
      }
      const sourceRawFindingIds = provisionalTransitionRawFindingIds(
        command,
        change.id,
      );
      const transitionRawFindings = [...sourceRawFindingIds]
        .sort(compareBinaryStrings)
        .map((rawFindingId) => {
          const rawFinding = input.proposed.rawFindings.find(
            (candidate) => candidate.rawFindingId === rawFindingId,
          );
          if (rawFinding === undefined) {
            throw new Error(
              `Provisional product transition references missing raw finding "${rawFindingId}"`,
            );
          }
          return rawFinding;
        });
      const product = createProductFindingEntry({
        ...change,
        revision: provisional.revision + 1,
      });
      const proof = issueProvisionalProductTransitionAuthorityProof({
        observationLedger: phase.observationLedger,
        intermediateLedger,
        operation: command.operation,
        findingId: change.id,
        transitionRawFindings,
        ...(command.replayOriginAuthorities === undefined
          ? {}
          : {
              replayOriginAuthorities: command.replayOriginAuthorities,
            }),
        product,
        workflowName: input.workflowName,
        runId: input.runId,
        scopeIdentity: input.scopeIdentity,
        reviewScopeSnapshotId: input.reviewScopeSnapshotId,
        observation: input.observation,
      });
      evidenceRecords.push(proof);
      proofIdsByFinding.set(
        change.id,
        [...(proofIdsByFinding.get(change.id) ?? []), proof.evidenceId],
      );
      const commandKey = managerProvisionalTransitionLifecycleCommandKey(command);
      if (phase.proofIdsByCommandKey.has(commandKey)) {
        throw new Error(`Provisional transition lifecycle command key collision "${commandKey}"`);
      }
      phase.proofIdsByCommandKey.set(commandKey, [proof.evidenceId]);
    }
  };
  if (
    input.rawRecoveryCurrent !== undefined
    && input.rawRecoveryManagerDecisionProposed !== undefined
  ) {
    issueTransitionProofs({
      observationLedger: input.rawRecoveryCurrent,
      intermediateLedger: input.rawRecoveryCurrent,
      commands: input.rawRecoveryManagerDecisionCommands ?? [],
      proofIdsByCommandKey:
        rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
    });
    issueTransitionProofs({
      observationLedger: input.rawRecoveryCurrent,
      intermediateLedger: input.rawRecoveryManagerDecisionProposed,
      commands: input.rawRecoverySettlementCommands ?? [],
      proofIdsByCommandKey: rawRecoveryProvisionalTransitionProofIdsByCommandKey,
      priorProofIdsByFinding: rawRecoveryProvisionalProofIdsByFinding,
    });
  }
  const rawRecoveryProofIdsByFinding = new Map<string, string[]>();
  const collectRawRecoveryProofIds = (proofIds: readonly string[]): void => {
    for (const proofId of proofIds) {
      const record = evidenceRecords.find(
        (candidate) => candidate.evidenceId === proofId,
      );
      if (
        record?.kind !== 'engine_proof'
        || record.targetFindingId === null
      ) {
        throw new Error(`Raw recovery lifecycle proof "${proofId}" has no finding target`);
      }
      rawRecoveryProofIdsByFinding.set(
        record.targetFindingId,
        [
          ...(rawRecoveryProofIdsByFinding.get(record.targetFindingId) ?? []),
          proofId,
        ],
      );
    }
  };
  collectRawRecoveryProofIds(
    [...rawRecoveryProvisionalProofIdsByFinding.values()].flat(),
  );
  collectRawRecoveryProofIds(
    [...rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey.values()]
      .flat(),
  );
  collectRawRecoveryProofIds(
    [...rawRecoveryProvisionalTransitionProofIdsByCommandKey.values()].flat(),
  );
  issueTransitionProofs({
    observationLedger: input.current,
    intermediateLedger: input.current,
    commands: input.managerDecisionCommands,
    proofIdsByCommandKey: managerDecisionProvisionalTransitionProofIdsByCommandKey,
    priorProofIdsByFinding: rawRecoveryProofIdsByFinding,
  });
  const settlementPriorProofIdsByFinding = new Map<string, string[]>();
  for (const findingId of new Set([
    ...rawRecoveryProofIdsByFinding.keys(),
    ...provisionalProofIdsByFinding.keys(),
  ])) {
    settlementPriorProofIdsByFinding.set(
      findingId,
      [
        ...(rawRecoveryProofIdsByFinding.get(findingId) ?? []),
        ...(provisionalProofIdsByFinding.get(findingId) ?? []),
      ].sort(compareBinaryStrings),
    );
  }
  issueTransitionProofs({
    observationLedger: input.current,
    intermediateLedger: input.managerDecisionProposed,
    commands: input.settlementCommands ?? [],
    proofIdsByCommandKey: provisionalTransitionProofIdsByCommandKey,
    priorProofIdsByFinding: settlementPriorProofIdsByFinding,
  });

  const rawRecoveryProofIds = new Set([
    ...[...rawRecoveryProvisionalProofIdsByFinding.values()].flat(),
    ...[...rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey.values()]
      .flat(),
    ...[...rawRecoveryProvisionalTransitionProofIdsByCommandKey.values()].flat(),
  ]);
  return {
    ledger: {
      ...input.proposed,
      evidenceRecords,
      findings: input.proposed.findings.map((finding) => {
        const proofIds = proofIdsByFinding.get(finding.id);
        if (proofIds === undefined) {
          return finding;
        }
        const detached = FindingLedgerEntrySchema.parse(finding);
        const currentRevision = input.current.findings.find(
          (candidate) => candidate.id === finding.id,
        )?.revision;
        const hasRevisionAdvancingProof = proofIds.some((proofId) => (
          !rawRecoveryProofIds.has(proofId)
          &&
          evidenceRecords.some((record) => (
            record.evidenceId === proofId
            && (
              record.kind !== 'engine_proof'
              || record.subject.kind !== 'finding_provisional_product_transition'
            )
          ))
        ));
        return {
          ...detached,
          ...(invalidationReasonsByFinding.has(detached.id)
            ? { invalidatedEvidence: invalidationReasonsByFinding.get(detached.id)! }
            : {}),
          evidenceIds: [...new Set([...detached.evidenceIds, ...proofIds])]
            .sort(compareBinaryStrings),
          ...(hasRevisionAdvancingProof && currentRevision === detached.revision
            ? { revision: detached.revision + 1 }
            : {}),
        };
      }),
    },
    provisionalProofIdsByFinding,
    rawRecoveryProvisionalProofIdsByFinding,
    invalidationProofIdsByFinding,
    duplicateProofIdsByCommandKey,
    managerDecisionProvisionalTransitionProofIdsByCommandKey,
    provisionalTransitionProofIdsByCommandKey,
    rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
    rawRecoveryProvisionalTransitionProofIdsByCommandKey,
    invalidationReasonsByFinding,
  };
}
