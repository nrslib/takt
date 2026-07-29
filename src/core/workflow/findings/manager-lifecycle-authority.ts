import { createHash } from 'node:crypto';
import { createEngineProofRecord } from '../../models/finding-evidence-record.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { FindingLedgerEntrySchema } from '../../models/finding-schemas.js';
import type { ManagerDecisionStageResult } from './manager-contracts.js';
import { computeInvalidLocationCandidates } from './manager-utils.js';
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
  proposed: FindingLedger;
  managerDecisionCommands: readonly FindingLifecycleCommand[];
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
  invalidationProofIdsByFinding: ReadonlyMap<string, readonly string[]>;
  duplicateProofIdsByCommandKey: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly string[]>
  >;
  invalidationReasonsByFinding: ReadonlyMap<string, string>;
} {
  const evidenceRecords = [...input.proposed.evidenceRecords];
  const proofIdsByFinding = new Map<string, string[]>();
  const provisionalProofIdsByFinding = new Map<string, string[]>();
  const invalidationProofIdsByFinding = new Map<string, string[]>();
  const duplicateProofIdsByCommandKey = new Map<
    string,
    ReadonlyMap<string, readonly string[]>
  >();
  const addProof = (
    findingId: string,
    subject: LifecycleAuthoritySubject,
    result: unknown,
  ): string => {
    const currentFinding = input.current.findings.find(
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
      claimIdentityHash: finding.claimIdentityHash,
      targetFindingId,
      subject,
      dependencyDigests: [
        captureFindingLifecycleHead(input.current, 'finding', findingId)?.projectionDigest
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

  for (const proposal of input.proposed.findings) {
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
    );
    provisionalProofIdsByFinding.set(
      finding.id,
      [...(provisionalProofIdsByFinding.get(finding.id) ?? []), proofId],
    );
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
        return {
          ...detached,
          ...(invalidationReasonsByFinding.has(detached.id)
            ? { invalidatedEvidence: invalidationReasonsByFinding.get(detached.id)! }
            : {}),
          evidenceIds: [...new Set([...detached.evidenceIds, ...proofIds])]
            .sort(compareBinaryStrings),
          ...(currentRevision === detached.revision
            ? { revision: detached.revision + 1 }
            : {}),
        };
      }),
    },
    provisionalProofIdsByFinding,
    invalidationProofIdsByFinding,
    duplicateProofIdsByCommandKey,
    invalidationReasonsByFinding,
  };
}
