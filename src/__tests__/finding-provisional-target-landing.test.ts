import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import {
  computeConflictHoldingAllocationId,
  computeConflictRawClaimLandingId,
  computeConflictRawClaimSnapshotDigest,
  computeConflictReactivationDigest,
} from '../core/models/finding-contract-identity.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { classifyConflictTarget } from '../core/workflow/findings/conflict-target.js';
import {
  findIndependentProvisionalDestination,
  independentProvisionalIdentity,
} from '../core/workflow/findings/independent-provisional-identity.js';
import { applyFindingLifecycleCommands } from '../core/workflow/findings/lifecycle-transaction.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { landUnownedConflictRawClaims } from '../core/workflow/findings/conflict-claim-landing.js';
import { refreshActiveConflictAdjudicationSnapshots } from '../core/workflow/findings/conflict-adjudication-model.js';
import { normalizeFindingLedger } from '../core/workflow/findings/ledger-mutation.js';
import { issueRawProvisionalIdentityProof } from '../core/workflow/findings/raw-provisional-identity-proof.js';
import { applyDedicatedCommitPlanOperations } from '../core/workflow/findings/manager-commit-plan.js';
import { createEmptyManagerOutput } from '../core/workflow/findings/manager-output.js';
import type { FindingLedger } from '../core/workflow/findings/types.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';

const OBSERVATION = {
  runId: 'run-provisional-landing',
  stepName: 'finding-manager',
  timestamp: '2026-08-03T00:00:00.000Z',
};

function claim(rawFindingId: string, reviewer = 'reviewer') {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: 'reviewer',
    reviewer,
    familyTag: 'bug',
    severity: 'high',
    title: 'Exact provisional claim',
    description: 'The same claim must attach without opening a conflict.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: { kind: 'code', paths: ['src/exact.ts'] },
    evidence: [{
      kind: 'file_quote',
      path: 'src/exact.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'export const exact = true;',
      snapshotId: 'a'.repeat(64),
    }],
  });
}

function provisionalLedger(
  provisionalKind: 'raw-adjudication-unresolved' | 'raw-meaning-ambiguous'
    = 'raw-adjudication-unresolved',
): FindingLedger {
  const source = claim('raw-source');
  const incoming = claim('raw-incoming', 'second-reviewer');
  return authorizeFindingLedgerFixture({
    workflowName: 'review',
    nextId: 2,
    updatedAt: OBSERVATION.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      revision: 1,
      severity: source.severity,
      title: source.title,
      description: source.description ?? undefined,
      target: source.target,
      targetIdentityHash: source.targetIdentityHash,
      claimIdentityHash: source.claimIdentityHash,
      semanticClaimIdentityHash: source.semanticClaimIdentityHash,
      evidenceIds: [],
      reviewers: [source.reviewer],
      rawFindingIds: [source.rawFindingId],
      firstSeen: OBSERVATION,
      lastSeen: OBSERVATION,
      provisional: {
        kind: provisionalKind,
        stableKey: '1'.repeat(64),
        lineageKey: '2'.repeat(64),
        sourceRawFindingIds: [source.rawFindingId],
        reason: 'Awaiting exact identity proof.',
        firstObservedAt: OBSERVATION,
        lastObservedAt: OBSERVATION,
        gateEffect: 'block',
        firstObservedRound: 1,
      },
    }],
    rawFindings: [source, incoming],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    conflicts: [],
    ...createEmptyFindingContractRegistries(),
  });
}

function evidenceRecord(source: ReturnType<typeof claim>) {
  const evidence = source.evidence[0]!;
  if (evidence.kind !== 'file_quote') {
    throw new Error('Expected file quote evidence');
  }
  const payload = {
    ...evidence,
    claimIdentityHash: source.claimIdentityHash,
    fileHash: 'f'.repeat(64),
  };
  return { evidenceId: computeFileQuoteEvidenceRecordId(payload), ...payload };
}

describe('provisional target landing', () => {
  it('attaches an exact three-hash raw claim through the dedicated operation', () => {
    let ledger = provisionalLedger();
    expect(classifyConflictTarget({ ledger, targetFindingId: 'F-0001' }).kind)
      .toBe('provisional_target');
    const issued = issueRawProvisionalIdentityProof({
      ledger,
      rawFindingId: 'raw-incoming',
      targetFindingId: 'F-0001',
      runId: OBSERVATION.runId,
      scopeIdentity: 'scope',
      contributionOrigin: { kind: 'external' },
      issuedAt: OBSERVATION.timestamp,
    });
    ledger = {
      ...ledger,
      evidenceRecords: [...ledger.evidenceRecords, issued.proofRecord],
    };
    const before = ledger.findings[0]!;
    const after = {
      ...before,
      lifecycle: 'persists' as const,
      revision: before.revision + 1,
      rawFindingIds: [...before.rawFindingIds, 'raw-incoming'].sort(),
      reviewers: [...before.reviewers, 'second-reviewer'].sort(),
      evidenceIds: [...before.evidenceIds, issued.proofRecord.evidenceId].sort(),
      lastSeen: structuredClone(OBSERVATION),
      provisional: {
        ...before.provisional!,
        sourceRawFindingIds: [
          ...before.provisional!.sourceRawFindingIds,
          'raw-incoming',
        ].sort(),
        lastObservedAt: structuredClone(OBSERVATION),
      },
    };
    const { revision: _revision, ...projection } = after;
    void _revision;
    const attached = applyFindingLifecycleCommands({
      ledger,
      commands: [{
        operation: 'attach_raw_to_provisional',
        changes: { findings: [projection], conflicts: [] },
        authority: issued.authority,
        evidenceSourcesByTarget: new Map([[
          'finding\0F-0001',
          {
            sourceRawFindingIds: ['raw-incoming'],
            authorityEvidenceIds: [issued.proofRecord.evidenceId],
          },
        ]]),
      }],
      occurredAt: OBSERVATION,
    });

    expect(attached.lifecycleEvents.at(-1)?.operation).toBe('attach_raw_to_provisional');
    expect(attached.findings[0]).toMatchObject({
      id: 'F-0001',
      revision: 2,
      rawFindingIds: ['raw-incoming', 'raw-source'],
      provisional: { sourceRawFindingIds: ['raw-incoming', 'raw-source'] },
    });
  });

  it('derives independent identity without reviewer or conflict-scoped inputs', () => {
    const first = claim('raw-a', 'reviewer-a');
    const identity = {
      targetIdentityHash: first.targetIdentityHash,
      claimIdentityHash: first.claimIdentityHash,
      semanticClaimIdentityHash: first.semanticClaimIdentityHash,
    };
    expect(independentProvisionalIdentity({
      ...identity,
      reviewer: 'reviewer-a',
      rejectedTargetFindingId: 'F-0001',
      conflictId: 'C-0001',
    })).toEqual(independentProvisionalIdentity({
      ...identity,
      reviewer: 'reviewer-b',
      rejectedTargetFindingId: 'F-9999',
      conflictId: 'C-9999',
    }));
  });

  it('rejects multiple independent provisional owners for one stable key', () => {
    const ledger = provisionalLedger();
    const duplicate = {
      ...ledger.findings[0]!,
      id: 'F-0002',
    };
    expect(() => findIndependentProvisionalDestination({
      ledger: { ...ledger, findings: [...ledger.findings, duplicate] },
      stableKey: ledger.findings[0]!.provisional!.stableKey,
    })).toThrow(/multiple open owners/);
  });

  it('reapplies the dedicated attachment after a commit plan is reconstructed', () => {
    const ledger = provisionalLedger();
    const target = ledger.findings[0]!;
    const incoming = ledger.rawFindings.find(
      (rawFinding) => rawFinding.rawFindingId === 'raw-incoming',
    )!;
    const { revision: _revision, ...genericProjection } = target;
    void _revision;
    const genericCommand = {
      operation: 'update_provisional' as const,
      changes: { findings: [genericProjection], conflicts: [] },
      authority: { kind: 'verified_evidence' as const },
      evidenceSourcesByTarget: new Map(),
    };
    const rebuiltPlan = {
      ledger,
      managerDecisionLedger: ledger,
      managerDecisionCommands: [genericCommand],
      managerOutput: createEmptyManagerOutput(),
      landedSpecs: [],
      entityMutationResults: [],
      normalizationRejections: [],
      rejectedObservationAttachments: [],
      settlementCommands: [],
    };
    const spec = {
      kind: target.provisional!.kind,
      stableKey: target.provisional!.stableKey,
      lineageKey: target.provisional!.lineageKey,
      sourceRawFindingIds: [incoming.rawFindingId],
      reason: 'Exact identity attachment after stale resolution filtering.',
      title: incoming.title!,
      severity: incoming.severity!,
      description: incoming.description!,
      reviewers: [incoming.reviewer],
      recoveryReviewerStableKey: 'reviewer-stable',
      target: incoming.target,
      targetIdentityHash: incoming.targetIdentityHash,
      claimIdentityHash: incoming.claimIdentityHash,
      semanticClaimIdentityHash: incoming.semanticClaimIdentityHash,
    };
    const rebuilt = applyDedicatedCommitPlanOperations({
      recoveryLedger: ledger,
      plan: rebuiltPlan,
      landings: [{
        candidate: {
          rawFindingId: incoming.rawFindingId,
          targetFindingId: target.id,
          evidence: spec.reason,
        },
        mode: 'attach_exact',
        destinationFindingId: target.id,
        spec,
      }],
      intake: {
        items: [{ wire: incoming, canonical: { reviewerStableKey: 'reviewer-stable' } }],
      } as never,
      observation: OBSERVATION,
      scopeIdentity: 'scope',
    });

    expect(rebuilt.managerDecisionCommands).toHaveLength(1);
    expect(rebuilt.managerDecisionCommands[0]).toMatchObject({
      operation: 'attach_raw_to_provisional',
      authority: {
        kind: 'verified_raw_provisional_identity',
        rawFindingId: incoming.rawFindingId,
        targetFindingId: target.id,
      },
    });
    expect(rebuilt.managerDecisionLedger.findings[0]!.rawFindingIds)
      .toContain(incoming.rawFindingId);
  });

  it('rejects an exact interpretation attachment degraded away from a raw-meaning target', () => {
    const ledger = provisionalLedger('raw-meaning-ambiguous');
    const target = ledger.findings[0]!;
    const incoming = ledger.rawFindings.find(
      (rawFinding) => rawFinding.rawFindingId === 'raw-incoming',
    )!;
    const { revision: _revision, ...genericProjection } = target;
    void _revision;
    const plan = {
      ledger,
      managerDecisionLedger: ledger,
      managerDecisionCommands: [{
        operation: 'update_provisional' as const,
        changes: { findings: [genericProjection], conflicts: [] },
        authority: { kind: 'verified_evidence' as const },
        evidenceSourcesByTarget: new Map(),
      }],
      managerOutput: createEmptyManagerOutput(),
      landedSpecs: [],
      entityMutationResults: [],
      normalizationRejections: [],
      rejectedObservationAttachments: [],
      settlementCommands: [],
    };
    const spec = {
      kind: target.provisional!.kind,
      stableKey: target.provisional!.stableKey,
      lineageKey: target.provisional!.lineageKey,
      sourceRawFindingIds: [incoming.rawFindingId],
      reason: 'attach_exact',
      title: incoming.title!,
      severity: incoming.severity!,
      description: incoming.description!,
      reviewers: [incoming.reviewer],
      recoveryReviewerStableKey: 'reviewer-stable',
      target: incoming.target,
      targetIdentityHash: incoming.targetIdentityHash,
      claimIdentityHash: incoming.claimIdentityHash,
      semanticClaimIdentityHash: incoming.semanticClaimIdentityHash,
    };
    const landing = {
      candidate: {
        rawFindingId: incoming.rawFindingId,
        targetFindingId: target.id,
        evidence: spec.reason,
      },
      mode: 'attach_exact' as const,
      spec,
      interpretationCaseId: 'interpretation-case',
    };
    const input = {
      recoveryLedger: ledger,
      plan,
      intake: {
        items: [{ wire: incoming, canonical: { reviewerStableKey: 'reviewer-stable' } }],
      } as never,
      observation: OBSERVATION,
      scopeIdentity: 'scope',
    };

    expect(() => applyDedicatedCommitPlanOperations({
      ...input,
      landings: [{ ...landing, destinationFindingId: null }],
    })).toThrow(/must retain rejected target/);

    const applied = applyDedicatedCommitPlanOperations({
      ...input,
      landings: [{ ...landing, destinationFindingId: target.id }],
    });
    expect(applied.managerDecisionCommands).toHaveLength(1);
    expect(applied.managerDecisionCommands[0]).toMatchObject({
      operation: 'attach_raw_to_provisional',
      authority: {
        kind: 'verified_raw_provisional_identity',
        rawFindingId: incoming.rawFindingId,
        targetFindingId: target.id,
      },
    });
    const command = applied.managerDecisionCommands[0]!;
    if (command.authority.kind !== 'verified_raw_provisional_identity') {
      throw new Error('Expected verified raw provisional identity authority');
    }
    expect(applied.managerDecisionLedger.evidenceBindings.filter((binding) => (
      binding.bindingId === command.authority.lifecycleEvidenceBindingId
    ))).toHaveLength(1);
  });

  it('reactivates a resolved product conflict with a new raw claim and exact holding plan', () => {
    const productRaw = claim('raw-product');
    const incoming = canonicalRawFindingFixture({
      ...claim('raw-reactivation'),
      rawFindingId: 'raw-reactivation',
      title: 'Conflicting reactivation claim',
      description: 'A new claim reopens the settled conflict epoch.',
      target: { kind: 'code', paths: ['src/reactivation.ts'] },
    });
    const conflictId = formatConflictId({ findingIds: ['F-0001'], rawFindingIds: [] });
    let ledger = authorizeFindingLedgerFixture({
      workflowName: 'review',
      nextId: 2,
      updatedAt: OBSERVATION.timestamp,
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        severity: productRaw.severity,
        title: productRaw.title,
        description: productRaw.description ?? undefined,
        target: productRaw.target,
        targetIdentityHash: productRaw.targetIdentityHash,
        claimIdentityHash: productRaw.claimIdentityHash,
        semanticClaimIdentityHash: productRaw.semanticClaimIdentityHash,
        evidenceIds: [],
        reviewers: [productRaw.reviewer],
        rawFindingIds: [productRaw.rawFindingId],
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
      }],
      rawFindings: [productRaw, incoming],
      evidenceRecords: [evidenceRecord(incoming)],
      evidenceBindings: [],
      lifecycleReservations: [],
      lifecycleEvents: [],
      conflicts: [{
        id: conflictId,
        status: 'resolved',
        revision: 2,
        findingIds: ['F-0001'],
        rawFindingIds: [],
        description: 'Previously settled conflict.',
        firstSeen: OBSERVATION,
        lastSeen: OBSERVATION,
        resolvedAt: OBSERVATION.timestamp,
        resolvedEvidence: 'Previously settled.',
      }],
      ...createEmptyFindingContractRegistries(),
    });
    const snapshot = ledger.rawCanonicalSnapshots.find(
      (candidate) => candidate.rawFindingId === incoming.rawFindingId,
    )!;
    const claimSnapshotDigest = computeConflictRawClaimSnapshotDigest(snapshot);
    const rawClaimLandingId = computeConflictRawClaimLandingId({
      conflictId,
      rawFindingId: incoming.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      claimSnapshotDigest,
    });
    const holdingAllocationId = computeConflictHoldingAllocationId(
      conflictId,
      [rawClaimLandingId],
    );
    const expectedConflictHead = captureFindingLifecycleHead(
      ledger,
      'conflict',
      conflictId,
    )!;
    const newRawClaim = {
      rawFindingId: incoming.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      claimSnapshotDigest,
      rawClaimLandingId,
      holdingAllocationId,
      holdingFindingId: 'F-0002',
    };
    const newRawClaims: [typeof newRawClaim] = [newRawClaim];
    const before = ledger.conflicts[0]!;
    const { resolvedAt: _resolvedAt, resolvedEvidence: _resolvedEvidence, ...unresolved } = before;
    void _resolvedAt;
    void _resolvedEvidence;
    const after = {
      ...unresolved,
      status: 'active' as const,
      revision: before.revision + 1,
      rawFindingIds: [incoming.rawFindingId],
      lastSeen: structuredClone(OBSERVATION),
    };
    const { revision: _revision, ...projection } = after;
    void _revision;
    ledger = applyFindingLifecycleCommands({
      ledger,
      commands: [{
        operation: 'reactivate_conflict',
        changes: { findings: [], conflicts: [projection] },
        authority: {
          kind: 'conflict_reactivation',
          conflictId,
          expectedConflictHead,
          newRawClaims,
          reactivationDigest: computeConflictReactivationDigest({
            conflictId,
            expectedConflictHead,
            newRawClaims,
          }),
        },
        evidenceSourcesByTarget: new Map(),
      }],
      occurredAt: OBSERVATION,
    });
    ledger = landUnownedConflictRawClaims({ ledger, observation: OBSERVATION });
    ledger = refreshActiveConflictAdjudicationSnapshots({
      ledger,
      originStep: OBSERVATION.stepName,
      createdAt: OBSERVATION,
    });

    expect(ledger.lifecycleEvents.some(({ operation }) => operation === 'reactivate_conflict'))
      .toBe(true);
    expect(ledger.conflictRawClaimLandings).toHaveLength(1);
    expect(normalizeFindingLedger(JSON.parse(JSON.stringify(ledger)), 'review'))
      .toEqual(ledger);
  });
});
